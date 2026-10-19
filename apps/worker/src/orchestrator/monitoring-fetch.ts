import type { SdkFetch } from "./retrying-fetch";

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Monitoring GETs only. The caller's deadline covers headers and the full body. */
export function createMonitoringFetch(deadline: AbortSignal): SdkFetch {
	return async (url, init) => {
		const target = new URL(url);
		const request = (init ?? {}) as RequestInit;
		if (
			target.origin !== "https://api.bitmovin.com" ||
			target.search ||
			target.hash ||
			(request.method ?? "GET").toUpperCase() !== "GET" ||
			!/^\/v1\/encoding\/encodings\/[^/]+\/(status|live\/heartbeat)$/.test(
				target.pathname,
			)
		) {
			throw new Error(
				"Monitoring transport refuses unrelated provider operation",
			);
		}
		const controller = new AbortController();
		const signal = AbortSignal.any([
			deadline,
			controller.signal,
			...(request.signal ? [request.signal] : []),
		]);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let cancellation: Promise<void> | undefined;
		const cancel = () => {
			if (reader && !cancellation) {
				cancellation = reader.cancel(signal.reason).catch(() => {});
			}
		};
		try {
			signal.throwIfAborted();
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
				if (size > MAX_RESPONSE_BYTES) {
					throw new Error("Monitoring response exceeds control-response limit");
				}
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
			await cancellation;
			signal.removeEventListener("abort", cancel);
			reader?.releaseLock();
		}
	};
}
