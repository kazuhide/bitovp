import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { LiveCaptureTarget } from "@bitovp/core";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureRenditionWindow } from "./live-capture";

// Real files/streams; observe only the final concatenation and inject local I/O failures.
const io = vi.hoisted(() => ({
	clipPath: "",
	reads: [] as import("node:fs").ReadStream[],
	sinks: [] as import("node:fs").WriteStream[],
	failReadAt: 0,
	failWrite: false,
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		createReadStream: (
			path: string,
			options?: Parameters<typeof fs.createReadStream>[1],
		) => {
			const stream = fs.createReadStream(
				io.reads.length + 1 === io.failReadAt ? `${path}.missing` : path,
				options,
			);
			io.reads.push(stream);
			return stream;
		},
		createWriteStream: (path: string) => {
			const stream = fs.createWriteStream(path);
			if (path === io.clipPath) {
				io.sinks.push(stream);
				if (io.failWrite) {
					stream._write = (_chunk, _encoding, callback) => {
						callback(new Error("injected capture write failure"));
					};
				}
			}
			return stream;
		},
	};
});

const target: LiveCaptureTarget = {
	renditionKey: "video",
	codec: "H264",
	height: 720,
	bitrate: 1_000_000,
	outputKey: "out",
	segmentPrefix: "video",
	kind: "TS",
	segmentNaming: "seg_%number%.ts",
	segmentLengthSec: 2,
};
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "capture-streams-"));
	io.clipPath = join(dir, "cap-video.ts");
	io.reads = [];
	io.sinks = [];
	io.failReadAt = 0;
	io.failWrite = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fixture(kind: "TS" | "FMP4" = "TS", large = false) {
	const keys = Array.from(
		{ length: 24 },
		(_, i) => `video/seg_${i + 1}.${kind === "TS" ? "ts" : "m4s"}`,
	);
	const ordered = kind === "FMP4" ? ["video/init.mp4", ...keys] : keys;
	const bodies = new Map(
		ordered.map((key) => [
			key,
			Buffer.from(`${key}\n`.repeat(large ? 20_000 : 1)),
		]),
	);
	const bodyFor = (key: string) => {
		const body = bodies.get(key);
		if (!body) throw new Error(`Unexpected fixture key: ${key}`);
		return body;
	};
	const browser: ObjectStorageBrowser = {
		listBuckets: async () => [],
		listObjects: async () => ({
			prefixes: [],
			objects: [...keys]
				.reverse()
				.map((key) => ({ key, size: bodies.get(key)?.length ?? 0 })),
		}),
		getObject: async ({ key }) => Readable.from([bodyFor(key)]),
		dispose: vi.fn(),
	};
	const credential = {
		provider: "AWS_S3" as const,
		config: { region: "us-east-1" },
		secret: { accessKeyId: "fake", secretAccessKey: "fake" },
	};
	const capture = () =>
		captureRenditionWindow({
			deps: {
				resolveCredential: async () => credential,
				makeBrowser: () => browser,
			},
			credential,
			bucket: "fake",
			jobDir: dir,
			now: Date.now(),
			windowSeconds: 120,
			fallbackCount: 24,
			target: {
				...target,
				kind,
				...(kind === "FMP4"
					? { segmentNaming: "seg_%number%.m4s", initSegmentName: "init.mp4" }
					: {}),
			},
		});
	return {
		capture,
		browser,
		ordered,
		expected: Buffer.concat(ordered.map(bodyFor)),
	};
}

describe("capture concatenation stream lifecycle", () => {
	it.each([
		"TS",
		"FMP4",
	] as const)("keeps 24 %s parts ordered and hashed without accumulating sink listeners", async (kind) => {
		io.clipPath = join(dir, `cap-video.${kind === "TS" ? "ts" : "mp4"}`);
		const { capture, browser, ordered, expected } = fixture(kind);
		const result = await capture();
		expect(readFileSync(result.clipPath)).toEqual(expected);
		expect(result.keys).toEqual(ordered);
		expect(result.segmentCount).toBe(24);
		expect(result.bytes).toBe(expected.length);
		expect(result.sha256).toBe(
			createHash("sha256").update(expected).digest("hex"),
		);
		expect(io.sinks).toHaveLength(1);
		for (const event of ["error", "close", "finish", "end"]) {
			expect(io.sinks[0]?.listenerCount(event), event).toBeLessThanOrEqual(10);
		}
		expect(io.reads).toHaveLength(ordered.length);
		expect(io.reads.every((stream) => stream.destroyed)).toBe(true);
		expect(io.reads.every((stream) => stream.closed)).toBe(true);
		expect(io.sinks[0]?.writableFinished).toBe(true);
		expect(browser.dispose).toHaveBeenCalledOnce();
	});

	it("propagates a later local read failure, closes streams, and opens no later parts", async () => {
		const { capture, browser } = fixture();
		io.failReadAt = 4;
		await expect(capture()).rejects.toThrow("ENOENT");
		expect(io.reads).toHaveLength(4);
		expect(io.reads.every((stream) => stream.destroyed)).toBe(true);
		await vi.waitFor(() =>
			expect(io.reads.every((stream) => stream.closed)).toBe(true),
		);
		expect(io.sinks[0]?.destroyed).toBe(true);
		expect(browser.dispose).toHaveBeenCalledOnce();
	});

	it("propagates a sink failure and destroys the current read without opening later parts", async () => {
		const { capture, browser } = fixture("TS", true);
		io.failWrite = true;
		await expect(capture()).rejects.toThrow("injected capture write failure");
		expect(io.reads).toHaveLength(1);
		expect(io.reads[0]?.destroyed).toBe(true);
		await vi.waitFor(() => expect(io.reads[0]?.closed).toBe(true));
		expect(io.sinks[0]?.destroyed).toBe(true);
		expect(browser.dispose).toHaveBeenCalledOnce();
	});
});
