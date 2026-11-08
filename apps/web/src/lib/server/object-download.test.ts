import { Readable } from "node:stream";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { ObjectVersionMismatchError } from "@bitovp/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import { serveObjectDownload } from "./object-download";
import type { ObjectPreviewTarget } from "./object-preview";

const browserFor = vi.hoisted(() => vi.fn());
vi.mock("./storage", () => ({ browserForCredentialId: browserFor }));

const CHUNK = 4 * 1024 * 1024;
const artifactId = "00000000-0000-4000-8000-000000000001";
const ctx = {} as ServerContext;
const url = `http://localhost/api/library/artifacts/${artifactId}/download?expectedOrganizationId=${artifactId}`;
const target = (): ObjectPreviewTarget => ({
	credentialId: artifactId,
	bucket: "private",
	key: "render.mp4",
	size: CHUNK * 2 + 17,
	expect: {
		size: CHUNK * 2 + 17,
		etag: '"fixed"',
		versionId: "version-1",
		generation: "7",
	},
	contentType: "video/mp4",
});
function bodyReader(response: Response) {
	if (!response.body) throw new Error("Missing download body");
	return response.body.getReader();
}
function wire() {
	const getObject = vi
		.fn<NonNullable<ObjectStorageBrowser["getObject"]>>()
		.mockImplementation(async ({ range }) => {
			if (!range || range.end === undefined) throw new Error("Unbounded read");
			return Readable.from([
				Buffer.alloc(range.end - range.start + 1, range.start / CHUNK + 1),
			]);
		});
	const disposals: ReturnType<typeof vi.fn>[] = [];
	browserFor.mockImplementation(async () => {
		const dispose = vi.fn();
		disposals.push(dispose);
		return { getObject, dispose };
	});
	return { getObject, disposals };
}
beforeEach(() => {
	browserFor.mockReset();
});

describe("fixed artifact download stream", () => {
	it("returns HEAD attachment headers after one fixed read without retaining a body stream", async () => {
		const { getObject, disposals } = wire();
		const fixed = target();
		const request = new Request(url, { method: "HEAD" });
		const addListener = vi.spyOn(request.signal, "addEventListener");
		const removeListener = vi.spyOn(request.signal, "removeEventListener");
		const response = await serveObjectDownload(ctx, request, fixed, artifactId);
		expect(response.status).toBe(200);
		expect(response.body).toBeNull();
		expect(response.headers.get("Content-Length")).toBe(String(fixed.size));
		expect(response.headers.get("Content-Disposition")).toBe(
			`attachment; filename="${artifactId}.mp4"`,
		);
		expect(getObject).toHaveBeenCalledTimes(1);
		expect(disposals[0]).toHaveBeenCalledOnce();
		expect(addListener).toHaveBeenCalledOnce();
		expect(removeListener).toHaveBeenCalledWith(
			"abort",
			addListener.mock.calls[0]?.[1],
		);
	});
	it("collects an artifact larger than 4MiB as a full attachment with bounded fixed reads", async () => {
		const { getObject, disposals } = wire();
		const fixed = target();
		const response = await serveObjectDownload(
			ctx,
			new Request(url),
			fixed,
			artifactId,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Length")).toBe(String(fixed.size));
		expect(response.headers.get("Content-Disposition")).toBe(
			`attachment; filename="${artifactId}.mp4"`,
		);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(getObject).toHaveBeenCalledTimes(1);
		fixed.expect.etag = "changed-after-response";
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(bytes.length).toBe(CHUNK * 2 + 17);
		expect([
			bytes[0],
			bytes[CHUNK - 1],
			bytes[CHUNK],
			bytes[CHUNK * 2],
			bytes.at(-1),
		]).toEqual([1, 1, 2, 3, 3]);
		expect(getObject.mock.calls.map(([input]) => input.range)).toEqual([
			{ start: 0, end: CHUNK - 1 },
			{ start: CHUNK, end: CHUNK * 2 - 1 },
			{ start: CHUNK * 2, end: CHUNK * 2 + 16 },
		]);
		for (const [input] of getObject.mock.calls)
			expect(input.expect).toEqual({
				size: CHUNK * 2 + 17,
				etag: '"fixed"',
				versionId: "version-1",
				generation: "7",
			});
		expect(disposals).toHaveLength(3);
		for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
	});
	it("does not prefetch another range until the reader pulls", async () => {
		const { getObject } = wire();
		const response = await serveObjectDownload(
			ctx,
			new Request(url),
			target(),
			artifactId,
		);
		const reader = bodyReader(response);
		await reader.read();
		await Promise.resolve();
		expect(getObject).toHaveBeenCalledTimes(1);
		await reader.cancel();
		expect(getObject).toHaveBeenCalledTimes(1);
	});
	it.each([
		"changed",
		"short",
	])("errors the body on a later %s range instead of completing mixed bytes", async (failure) => {
		const { getObject, disposals } = wire();
		getObject.mockImplementationOnce(async () =>
			Readable.from([Buffer.alloc(CHUNK, 1)]),
		);
		getObject.mockImplementationOnce(async () => {
			if (failure === "changed")
				throw new ObjectVersionMismatchError("private", "render.mp4", {
					etag: "private-expect",
				});
			return Readable.from([Buffer.alloc(2)]);
		});
		const response = await serveObjectDownload(
			ctx,
			new Request(url),
			target(),
			artifactId,
		);
		expect(response.status).toBe(200);
		await expect(response.arrayBuffer()).rejects.toThrow();
		expect(getObject).toHaveBeenCalledTimes(2);
		expect(disposals).toHaveLength(2);
		for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
	});
	it("keeps a failed HEAD response bodyless after releasing the first range", async () => {
		const { getObject, disposals } = wire();
		getObject.mockRejectedValueOnce(
			new ObjectVersionMismatchError("private", "render.mp4", {
				etag: "private-expect",
			}),
		);
		const response = await serveObjectDownload(
			ctx,
			new Request(url, { method: "HEAD" }),
			target(),
			artifactId,
		);
		expect(response.status).toBe(409);
		expect(response.body).toBeNull();
		expect(disposals[0]).toHaveBeenCalledOnce();
	});
	it.each([
		["changed", 409],
		["missing", 404],
		["short", 502],
	] as const)("preserves the first range %s HTTP failure", async (failure, status) => {
		const { getObject, disposals } = wire();
		getObject.mockImplementationOnce(async () => {
			if (failure === "changed")
				throw new ObjectVersionMismatchError("private", "render.mp4", {
					etag: "private-expect",
				});
			if (failure === "missing") throw { $metadata: { httpStatusCode: 404 } };
			return Readable.from([Buffer.alloc(2)]);
		});
		const response = await serveObjectDownload(
			ctx,
			new Request(url),
			target(),
			artifactId,
		);
		expect(response.status).toBe(status);
		expect(await response.text()).not.toMatch(
			/private|render.mp4|private-expect/,
		);
		expect(getObject).toHaveBeenCalledTimes(1);
		expect(disposals[0]).toHaveBeenCalledOnce();
	});
	it("cancels a pending range read and disposes its source when the reader cancels", async () => {
		const { getObject, disposals } = wire();
		let began!: () => void;
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		let current: Readable | undefined;
		getObject.mockImplementationOnce(async () =>
			Readable.from([Buffer.alloc(CHUNK, 1)]),
		);
		getObject.mockImplementationOnce(async () => {
			current = new Readable({
				read() {
					began();
				},
			});
			return current;
		});
		const response = await serveObjectDownload(
			ctx,
			new Request(url),
			target(),
			artifactId,
		);
		const reader = bodyReader(response);
		await reader.read();
		const next = reader.read();
		await started;
		await reader.cancel();
		expect(await next).toEqual({ done: true, value: undefined });
		expect(current?.destroyed).toBe(true);
		expect(disposals[1]).toHaveBeenCalledOnce();
		expect(getObject).toHaveBeenCalledTimes(2);
	});
	it("does not open storage for an already canceled request", async () => {
		wire();
		const abort = new AbortController();
		abort.abort();
		const response = await serveObjectDownload(
			ctx,
			new Request(url, { signal: abort.signal }),
			target(),
			artifactId,
		);
		expect(response.status).toBe(408);
		expect(browserFor).not.toHaveBeenCalled();
	});
	it("aborts and disposes an in-flight range when the original request aborts", async () => {
		const { getObject, disposals } = wire();
		let began!: () => void;
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		let current: Readable | undefined;
		getObject.mockImplementationOnce(async () =>
			Readable.from([Buffer.alloc(CHUNK, 1)]),
		);
		getObject.mockImplementationOnce(async () => {
			current = new Readable({
				read() {
					began();
				},
			});
			return current;
		});
		const abort = new AbortController();
		const response = await serveObjectDownload(
			ctx,
			new Request(url, { signal: abort.signal }),
			target(),
			artifactId,
		);
		const reader = bodyReader(response);
		await reader.read();
		const rejection = expect(reader.read()).rejects.toThrow(
			"Media download canceled",
		);
		await started;
		abort.abort();
		await rejection;
		expect(current?.destroyed).toBe(true);
		expect(disposals[1]).toHaveBeenCalledOnce();
	});
	it("refuses an unverified target without opening storage", async () => {
		wire();
		const fixed = target();
		fixed.expect = { size: fixed.size, versionId: "null" };
		expect(
			(await serveObjectDownload(ctx, new Request(url), fixed, artifactId))
				.status,
		).toBe(409);
		expect(browserFor).not.toHaveBeenCalled();
	});
});
