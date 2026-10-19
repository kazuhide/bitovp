import { once } from "node:events";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { setImmediate } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { beforeEach, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	read: vi.fn(),
	job: {
		id: "00000000-0000-4000-8000-000000000001",
		model: "model",
		results: [
			{
				id: "00000000-0000-4000-8000-000000000002",
				renditionRef: { label: "First" },
			},
			{
				id: "00000000-0000-4000-8000-000000000003",
				renditionRef: { label: "Second" },
			},
		],
	},
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			appSetting: { findUnique: async () => ({ value: { qcVmaf: true } }) },
			vmafJob: { findUnique: async () => store.job },
			vmafResult: { findFirst: store.read },
		},
	}),
}));

import { GET } from "./route";

const frames = Array.from({ length: 100_000 }, (_, frameNum) => ({
	frameNum,
	vmaf: 91.23456789012344,
	psnr: 42.123456789,
}));
const blob = gzipSync(JSON.stringify(frames));

beforeEach(() => {
	vi.clearAllMocks();
	store.read.mockImplementation(async ({ where }) => {
		expect(where.vmafJobId).toBe(store.job.id);
		expect(store.job.results.some((result) => result.id === where.id)).toBe(
			true,
		);
		return { framesGzip: blob };
	});
});

async function withHttp(
	format: "json" | "csv",
	run: (url: string, settled: Promise<void>) => Promise<void>,
) {
	let finish: () => void = () => {};
	const settled = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const server = createServer(async (incoming, outgoing) => {
		const abort = new AbortController();
		outgoing.once("close", () => abort.abort());
		try {
			const response = await GET(
				new Request(`http://127.0.0.1${incoming.url}`, {
					signal: abort.signal,
				}),
				{ params: Promise.resolve({ id: store.job.id }) },
			);
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			await pipeline(
				Readable.fromWeb(
					response.body as unknown as NodeReadableStream<Uint8Array>,
				),
				outgoing,
			);
		} catch {
			outgoing.destroy();
		} finally {
			finish();
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		await run(
			`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/vmaf-jobs/${store.job.id}/export?format=${format}`,
			settled,
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

it("completes an exact JSON download over real HTTP with a yielding consumer", async () => {
	const small = frames.slice(0, 50);
	store.read.mockResolvedValue({ framesGzip: gzipSync(JSON.stringify(small)) });
	await withHttp("json", async (url, settled) => {
		const response = await fetch(url);
		const pieces: Uint8Array[] = [];
		if (!response.body) throw new Error("Missing response body");
		const reader = response.body.getReader();
		for (;;) {
			const piece = await reader.read();
			if (piece.done) break;
			pieces.push(piece.value);
			await setImmediate();
		}
		await settled;
		expect(response.status).toBe(200);
		expect(Buffer.concat(pieces).toString()).toBe(
			JSON.stringify(
				{
					vmafJobId: store.job.id,
					model: store.job.model,
					renditions: store.job.results.map((result) => ({
						id: result.id,
						label: result.renditionRef.label,
						renditionRef: result.renditionRef,
						frames: small,
					})),
				},
				null,
				2,
			),
		);
		expect(store.read).toHaveBeenCalledTimes(2);
	});
});

it.each([
	"json",
	"csv",
] as const)("stops decoding and never fetches the next rendition after an HTTP %s disconnect", async (format) => {
	await withHttp(format, async (url, settled) => {
		const response = await new Promise<import("node:http").IncomingMessage>(
			(resolve, reject) => get(url, resolve).once("error", reject),
		);
		response.once("data", () => response.destroy());
		await once(response, "close");
		await settled;
		expect(store.read).toHaveBeenCalledTimes(1);
	});
});

it.each([
	"json",
	"csv",
] as const)("breaks the HTTP %s body on a late checksum failure instead of completing a truncated file", async (format) => {
	const corrupt = Buffer.from(blob);
	corrupt.writeUInt8(
		corrupt.readUInt8(corrupt.length - 8) ^ 1,
		corrupt.length - 8,
	);
	store.read.mockResolvedValue({ framesGzip: corrupt });
	await withHttp(format, async (url, settled) => {
		const response = await new Promise<import("node:http").IncomingMessage>(
			(resolve, reject) => get(url, resolve).once("error", reject),
		);
		let bytes = 0;
		const consume = async () => {
			for await (const chunk of response) bytes += chunk.byteLength;
		};
		await expect(consume()).rejects.toThrow();
		await settled;
		expect(response.statusCode).toBe(200);
		expect(bytes).toBeGreaterThan(0);
		expect(response.complete).toBe(false);
		expect(store.read).toHaveBeenCalledTimes(1);
	});
});
