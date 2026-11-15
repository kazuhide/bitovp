import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createS3Browser } from "./s3";

const owned: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of owned.splice(0).reverse()) await close();
});

async function fixture(readTimeoutMs = 80) {
	const directory = await mkdtemp(join(tmpdir(), "bitovp-put-timeout-"));
	owned.push(() => rm(directory, { recursive: true, force: true }));
	const filePath = join(directory, "input.mp4");
	await writeFile(filePath, Buffer.alloc(1024, 1));
	let closed = false;
	const requestedUrls: string[] = [];
	const server = createServer((req, res) => {
		requestedUrls.push(req.url ?? "");
		res.on("close", () => {
			closed = true;
		});
		req.resume();
		req.on("end", () => {
			setTimeout(() => {
				if (!res.destroyed) {
					res.writeHead(200, { etag: '"uploaded"', "content-length": "0" });
					res.end();
				}
			}, 200);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	owned.push(
		() =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	);
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Expected loopback server");
	const browser = createS3Browser({
		region: "us-east-1",
		endpoint: `http://127.0.0.1:${address.port}`,
		forcePathStyle: true,
		credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
		readTimeoutMs,
	});
	owned.push(async () => browser.dispose?.());
	return { browser, filePath, closed: () => closed, requestedUrls };
}

it("uses a bounded PUT-specific client while keeping HEAD's short readiness timeout", async () => {
	const f = await fixture();
	await expect(
		f.browser.putObject?.({
			bucket: "fixture",
			key: "prepared.mp4",
			filePath: f.filePath,
			timeoutMs: 1000,
		}),
	).resolves.toBeUndefined();
	await expect(
		f.browser.headObject?.({ bucket: "fixture", key: "prepared.mp4" }),
	).rejects.toThrow();
	expect(f.requestedUrls.every((url) => !url.includes("x-id"))).toBe(true);
});

it("aborts the owned upload client and socket promptly on cancellation", async () => {
	const f = await fixture(1000);
	const controller = new AbortController();
	const upload = f.browser.putObject?.({
		bucket: "fixture",
		key: "prepared.mp4",
		filePath: f.filePath,
		timeoutMs: 1000,
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 30);
	await expect(upload).rejects.toThrow();
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(f.closed()).toBe(true);
});
