import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import type { VodInputTimelineSource } from "@bitovp/core/vod-input-timeline";
import {
	type ObjectIdentity,
	type ObjectStorageBrowser,
	ObjectVersionMismatchError,
	VersionExpectationUnsupportedError,
} from "@bitovp/storage";
import { MediaOperationError } from "../library-editing/process";

export type PinnedVodInputSource = {
	source: VodInputTimelineSource;
	identity: ObjectIdentity;
};
export type VodInputBrowserFactory = (
	credentialId: string,
) => Promise<ObjectStorageBrowser>;

/** Storage SDK promises do not all support AbortSignal; late streams must be destroyed. */
export function abortableVodOperation<T>(
	pending: Promise<T>,
	signal: AbortSignal,
	dispose?: (value: T) => void,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const canceled = () =>
			reject(signal.reason ?? new MediaOperationError("CANCELED"));
		signal.addEventListener("abort", canceled, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", canceled);
				if (signal.aborted) {
					dispose?.(value);
					canceled();
				} else resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", canceled);
				reject(signal.aborted ? signal.reason : error);
			},
		);
		if (signal.aborted) canceled();
	});
}

export function assertVodSourceIdentity(identity: ObjectIdentity): void {
	if (
		!Number.isSafeInteger(identity.size) ||
		identity.size <= 0 ||
		!(
			identity.etag?.trim() ||
			(identity.versionId?.trim() && identity.versionId !== "null") ||
			identity.generation?.trim()
		)
	)
		throw new MediaOperationError("SOURCE_UNVERIFIED");
}

/** The only HTTP inputs the fixed media program can reach: random paths on loopback.
 * Every GET remains a conditional, arrival-bounded storage read, including seeks. */
export async function createVodRangeBridge(input: {
	sources: readonly PinnedVodInputSource[];
	browserFor: VodInputBrowserFactory;
	signal?: AbortSignal;
	maxBytes?: number;
	maxRequestBytes?: number;
	timeoutMs?: number;
}) {
	const maxBytes = input.maxBytes ?? 256 * 1024 ** 2;
	const maxRequestBytes = input.maxRequestBytes ?? 8 * 1024 ** 2;
	const timeoutMs = input.timeoutMs ?? 15_000;
	for (const value of [maxBytes, maxRequestBytes, timeoutMs]) {
		if (!Number.isSafeInteger(value) || value < 1)
			throw new RangeError("Invalid preview transfer bound");
	}
	for (const entry of input.sources) assertVodSourceIdentity(entry.identity);
	if (
		new Set(input.sources.map((entry) => entry.source.key)).size !==
		input.sources.length
	)
		throw new MediaOperationError("INVALID_SOURCE");
	const token = randomBytes(32).toString("hex");
	const shutdown = new AbortController();
	const stop = () => shutdown.abort(new MediaOperationError("CANCELED"));
	input.signal?.addEventListener("abort", stop, { once: true });
	const sockets = new Set<Socket>();
	const streams = new Set<Readable>();
	const browsers = new Map<string, Promise<ObjectStorageBrowser>>();
	let transferred = 0,
		requests = 0,
		active = 0;
	let failure: MediaOperationError | undefined;
	const fail = (error: unknown) => {
		failure ??=
			error instanceof ObjectVersionMismatchError
				? new MediaOperationError("SOURCE_CHANGED")
				: error instanceof VersionExpectationUnsupportedError
					? new MediaOperationError("SOURCE_UNVERIFIED")
					: error instanceof MediaOperationError
						? error
						: new MediaOperationError("SOURCE_READ_FAILED");
		return failure;
	};
	const respond = (res: ServerResponse, status: number) => {
		res.writeHead(status, {
			"Content-Length": "0",
			"Cache-Control": "no-store",
			Connection: "close",
		});
		res.end();
	};
	const server = createServer((req, res) => {
		void (async () => {
			if (shutdown.signal.aborted) return respond(res, 503);
			const index = input.sources.findIndex(
				(_entry, i) => req.url === `/${token}/${i}`,
			);
			const entry = input.sources[index];
			if (!entry) return respond(res, 404);
			if (req.method !== "GET" && req.method !== "HEAD")
				return respond(res, 405);
			if (req.method === "HEAD") {
				res.writeHead(200, {
					"Content-Length": entry.identity.size,
					"Accept-Ranges": "bytes",
					"Cache-Control": "no-store",
				});
				return res.end();
			}
			const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
			if (!match) return respond(res, 416);
			const start = Number(match[1]),
				requestedEnd = match[2] ? Number(match[2]) : entry.identity.size - 1;
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(requestedEnd) ||
				start < 0 ||
				start >= entry.identity.size ||
				requestedEnd < start
			)
				return respond(res, 416);
			if (++requests > 512 || active >= 2 || transferred >= maxBytes) {
				fail(new MediaOperationError("SOURCE_READ_LIMIT"));
				return respond(res, 429);
			}
			const end = Math.min(
				requestedEnd,
				entry.identity.size - 1,
				start + maxRequestBytes - 1,
				start + maxBytes - transferred - 1,
			);
			const cancel = new AbortController();
			const signal = AbortSignal.any([
				shutdown.signal,
				cancel.signal,
				AbortSignal.timeout(timeoutMs),
			]);
			let stream: Readable | undefined;
			const onClose = () => {
				cancel.abort();
				stream?.destroy();
			};
			res.on("close", onClose);
			active++;
			try {
				let browser = browsers.get(entry.source.credentialId);
				if (!browser) {
					browser = input.browserFor(entry.source.credentialId);
					browsers.set(entry.source.credentialId, browser);
				}
				const resolved = await abortableVodOperation(browser, signal);
				if (!resolved.getObject)
					throw new MediaOperationError("SOURCE_UNSUPPORTED");
				stream = await abortableVodOperation(
					resolved.getObject({
						bucket: entry.source.bucket,
						key: entry.source.objectKey,
						expect: entry.identity,
						range: { start, end },
					}) as Promise<Readable>,
					signal,
					(late) => late.destroy(),
				);
				streams.add(stream);
				const abort = () =>
					stream?.destroy(
						signal.reason instanceof Error
							? signal.reason
							: new MediaOperationError("CANCELED"),
					);
				signal.addEventListener("abort", abort, { once: true });
				try {
					res.writeHead(206, {
						"Content-Length": end - start + 1,
						"Content-Range": `bytes ${start}-${end}/${entry.identity.size}`,
						"Content-Type": "application/octet-stream",
						"Accept-Ranges": "bytes",
						"Cache-Control": "no-store",
					});
					let bytes = 0;
					for await (const chunk of stream) {
						if (signal.aborted) throw signal.reason;
						const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						bytes += buffer.length;
						transferred += buffer.length;
						if (bytes > end - start + 1)
							throw new MediaOperationError("SOURCE_RANGE_INVALID");
						if (transferred > maxBytes)
							throw new MediaOperationError("SOURCE_READ_LIMIT");
						if (!res.write(buffer))
							await abortableVodOperation(
								new Promise<void>((resolve) => res.once("drain", resolve)),
								signal,
							);
					}
					if (bytes !== end - start + 1)
						throw new MediaOperationError("SOURCE_INCOMPLETE");
					res.end();
				} finally {
					signal.removeEventListener("abort", abort);
				}
			} catch (error) {
				if (!cancel.signal.aborted && !shutdown.signal.aborted) {
					const reason = fail(
						signal.aborted
							? new MediaOperationError("SOURCE_READ_TIMED_OUT")
							: error,
					);
					if (!res.headersSent)
						respond(res, reason.code === "SOURCE_CHANGED" ? 409 : 502);
					else res.destroy();
				}
			} finally {
				res.removeListener("close", onClose);
				stream?.destroy();
				if (stream) streams.delete(stream);
				active--;
			}
		})().catch(() => res.destroy());
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.requestTimeout = timeoutMs;
	server.headersTimeout = timeoutMs;
	server.maxConnections = 4;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new MediaOperationError("BRIDGE_UNAVAILABLE");
	let closed: Promise<void> | undefined;
	const close = () =>
		(closed ??= (async () => {
			stop();
			input.signal?.removeEventListener("abort", stop);
			for (const stream of streams) stream.destroy();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			for (const browser of browsers.values())
				void browser.then(
					(value) => value.dispose?.(),
					() => {},
				);
		})());
	if (input.signal?.aborted) {
		await close();
		throw new MediaOperationError("CANCELED");
	}
	return {
		urlFor(key: string) {
			const index = input.sources.findIndex(
				(entry) => entry.source.key === key,
			);
			if (index < 0) throw new MediaOperationError("INVALID_SOURCE");
			return `http://127.0.0.1:${address.port}/${token}/${index}`;
		},
		get bytesRead() {
			return transferred;
		},
		throwIfFailed() {
			if (failure) throw failure;
		},
		close,
	};
}
