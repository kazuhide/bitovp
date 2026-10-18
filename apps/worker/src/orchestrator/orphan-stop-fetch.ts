import type { SdkFetch } from "./retrying-fetch";

/** Small control responses only; never media. Fail closed above 1 MiB. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEADLINE_MS = 8_000;

/** Orphan reconciliation only: one transport attempt, including body download.
 * Abort is delivered to native fetch AND its body reader. Cancellation is
 * awaited; no detached Promise.race leaves an old STOP running behind Retry.
 * This bounds transport, not database/audit waits or provider completion. */
export function createOrphanStopFetch(): SdkFetch {
	return async (url, init) => {
		const target = new URL(url);
		const request = (init ?? {}) as RequestInit;
		const method = (request.method ?? "GET").toUpperCase();
		if (
			target.origin !== "https://api.bitmovin.com" ||
			target.search ||
			target.hash ||
			!(method === "GET"
				? /^\/v1\/encoding\/encodings\/[^/]+\/status$/.test(target.pathname)
				: method === "POST" &&
					/^\/v1\/encoding\/encodings\/[^/]+\/stop$/.test(target.pathname))
		)
			throw new Error("Orphan transport refuses unrelated provider operation");
		const controller = new AbortController();
		const signal = request.signal
			? AbortSignal.any([request.signal, controller.signal])
			: controller.signal;
		const timer = setTimeout(
			() => controller.abort(new Error("Orphan transport deadline exceeded")),
			DEADLINE_MS,
		);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let cancellation: Promise<void> | undefined;
		const cancel = () => {
			if (reader && !cancellation)
				cancellation = reader.cancel(signal.reason).catch(() => {});
		};
		try {
			const response = await fetch(url, {
				...request,
				signal,
				redirect: "error",
			});
			reader = response.body?.getReader();
			signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) cancel();
			signal.throwIfAborted();
			const chunks: Uint8Array[] = [];
			let size = 0;
			while (reader) {
				const next = await reader.read();
				signal.throwIfAborted();
				if (next.done) break;
				size += next.value.byteLength;
				if (size > MAX_RESPONSE_BYTES)
					throw new Error("Orphan response exceeds control-response limit");
				chunks.push(next.value);
			}
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return new Response(response.body === null ? null : bytes, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} catch (error) {
			controller.abort(error);
			cancel();
			throw error;
		} finally {
			clearTimeout(timer);
			await cancellation;
			signal.removeEventListener("abort", cancel);
			reader?.releaseLock();
		}
	};
}
