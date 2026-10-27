import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { setImmediate as turn } from "node:timers/promises";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEngineDeps } from "./adapters";

// Keep real files and streams; observe concatenation and inject local I/O failures.
const io = vi.hoisted(() => ({
	reads: [] as import("node:fs").ReadStream[],
	sinks: [] as import("node:fs").WriteStream[],
	listenerCounts: [] as number[][],
	failReadAt: 0,
	failWrite: false,
	closeEarly: false,
	slowWrite: false,
	maxBufferedBytes: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		createReadStream: (
			path: string,
			options?: Parameters<typeof fs.createReadStream>[1],
		) => {
			const sink = io.sinks.at(-1);
			if (sink)
				io.listenerCounts.push(
					["error", "close", "finish", "end"].map((event) =>
						sink.listenerCount(event),
					),
				);
			const stream = fs.createReadStream(
				io.reads.length + 1 === io.failReadAt ? `${path}.missing` : path,
				{
					...(typeof options === "string" ? { encoding: options } : options),
					highWaterMark: 1024,
				},
			);
			io.reads.push(stream);
			return stream;
		},
		createWriteStream: (path: string) => {
			const concat = basename(path).startsWith("concat_");
			const stream = fs.createWriteStream(
				path,
				concat ? { highWaterMark: 1024 } : undefined,
			);
			if (concat) {
				io.sinks.push(stream);
				const write = stream._write.bind(stream);
				stream._write = (chunk, encoding, callback) => {
					io.maxBufferedBytes = Math.max(
						io.maxBufferedBytes,
						stream.writableLength,
					);
					if (io.failWrite)
						callback(new Error("injected concatenation write failure"));
					else if (io.closeEarly) {
						stream.destroy();
						callback();
					} else if (io.slowWrite)
						setTimeout(() => write(chunk, encoding, callback), 1);
					else write(chunk, encoding, callback);
				};
			}
			return stream;
		},
	};
});

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "verify-concatenation-"));
	io.reads = [];
	io.sinks = [];
	io.listenerCounts = [];
	io.failReadAt = 0;
	io.failWrite = false;
	io.closeEarly = false;
	io.slowWrite = false;
	io.maxBufferedBytes = 0;
});
afterEach(async () => {
	for (const stream of [...io.reads, ...io.sinks]) stream.destroy();
	await turn();
	await rm(dir, { recursive: true, force: true });
});

function fixture() {
	const keys = Array.from({ length: 12 }, (_, index) => `part-${index}.bin`);
	const bodies = new Map(
		keys.map((key, index) => [key, Buffer.alloc(16 * 1024, 65 + index)]),
	);
	const getObject = vi.fn<NonNullable<ObjectStorageBrowser["getObject"]>>(
		async ({ key }) => {
			const body = bodies.get(key);
			if (!body) throw new Error(`Missing synthetic object: ${key}`);
			return Readable.from([body]);
		},
	);
	const browser: ObjectStorageBrowser = {
		listBuckets: async () => ["synthetic"],
		listObjects: async () => ({ objects: [], prefixes: [] }),
		getObject,
	};
	const deps = makeEngineDeps({
		outputFor: () => ({ bucket: "synthetic", browser }),
		scratchDir: dir,
		ffprobePath: "not-used",
	});
	return {
		deps,
		keys,
		getObject,
		expected: Buffer.concat([...bodies.values()]),
	};
}

describe("verification concatenation stream lifecycle", () => {
	it("joins twelve real parts in order with stable sink listeners and no listener warning", async () => {
		const { deps, keys, getObject, expected } = fixture();
		const warnings: string[] = [];
		const onWarning = (warning: Error & { emitter?: unknown }) => {
			if (
				warning.name === "MaxListenersExceededWarning" &&
				io.sinks.includes(warning.emitter as import("node:fs").WriteStream)
			)
				warnings.push(warning.message);
		};
		process.on("warning", onWarning);
		try {
			const path = await deps.fetchConcatenated("origin", keys);
			const bytes = await readFile(path);
			expect(bytes).toEqual(expected);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(
				createHash("sha256").update(expected).digest("hex"),
			);
			await turn();
			expect(warnings).toEqual([]);
			expect(io.sinks).toHaveLength(1);
			expect(io.listenerCounts).toHaveLength(keys.length);
			expect(
				io.listenerCounts.every(
					(counts) =>
						JSON.stringify(counts) === JSON.stringify(io.listenerCounts[0]),
				),
			).toBe(true);
			expect(io.sinks[0]?.writableFinished).toBe(true);
			expect(io.sinks[0]?.closed).toBe(true);
			expect(
				io.reads.every((stream) => stream.destroyed && stream.closed),
			).toBe(true);
			for (const event of ["error", "close", "finish", "end"])
				expect(io.sinks[0]?.listenerCount(event), event).toBeLessThanOrEqual(
					10,
				);
			expect(await deps.fetchConcatenated("origin", keys)).toBe(path);
			expect(getObject).toHaveBeenCalledTimes(keys.length);
			expect(io.sinks).toHaveLength(1);
		} finally {
			process.off("warning", onWarning);
		}
	});
	it("honors a slow destination's backpressure without buffering the complete assembly", async () => {
		const { deps, keys, expected } = fixture();
		io.slowWrite = true;
		const path = await deps.fetchConcatenated("origin", keys);
		expect(await readFile(path)).toEqual(expected);
		expect(io.maxBufferedBytes).toBeGreaterThan(0);
		expect(io.maxBufferedBytes).toBeLessThanOrEqual(1024);
		expect(io.maxBufferedBytes).toBeLessThan(expected.length);
	});
	it("removes a partial assembly after a later read fails and caches only a successful retry", async () => {
		const { deps, keys, expected, getObject } = fixture();
		io.failReadAt = 4;
		await expect(deps.fetchConcatenated("origin", keys)).rejects.toThrow(
			"ENOENT",
		);
		expect(io.reads).toHaveLength(4);
		expect(io.reads.every((stream) => stream.destroyed)).toBe(true);
		expect(io.sinks[0]?.destroyed).toBe(true);
		await expect(stat(String(io.sinks[0]?.path))).rejects.toMatchObject({
			code: "ENOENT",
		});
		io.failReadAt = 0;
		const path = await deps.fetchConcatenated("origin", keys);
		expect(await readFile(path)).toEqual(expected);
		expect(io.sinks).toHaveLength(2);
		expect(await deps.fetchConcatenated("origin", keys)).toBe(path);
		expect(io.sinks).toHaveLength(2);
		expect(getObject).toHaveBeenCalledTimes(keys.length);
	});
	it.each([
		"sink error",
		"early termination",
	] as const)("closes the active read and removes partial output on %s", async (failure) => {
		const { deps, keys } = fixture();
		io.failWrite = failure === "sink error";
		io.closeEarly = failure === "early termination";
		await expect(deps.fetchConcatenated("origin", keys)).rejects.toThrow(
			failure === "sink error"
				? "injected concatenation write failure"
				: "Premature close",
		);
		expect(io.reads).toHaveLength(1);
		expect(io.reads[0]?.destroyed).toBe(true);
		await vi.waitFor(() => expect(io.reads[0]?.closed).toBe(true));
		expect(io.sinks[0]?.destroyed).toBe(true);
		expect(io.sinks[0]?.closed).toBe(true);
		await expect(stat(String(io.sinks[0]?.path))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
