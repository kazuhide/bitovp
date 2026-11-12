import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VodInputPreviewRequest } from "@bitovp/core/vod-input-timeline";
import {
	type ObjectStorageBrowser,
	ObjectVersionMismatchError,
} from "@bitovp/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MediaOperationError,
	type runMediaProcess,
} from "../library-editing/process";
import { renderVodInputPreview } from "./media";

const source = {
	key: "a",
	credentialId: "00000000-0000-4000-8000-000000000001",
	bucket: "media",
	objectKey: "a.mp4",
};
const identity = { size: 1000, etag: '"pinned-v1"' };
const facts = {
	key: "a",
	durationMs: 2000,
	identity,
	video: {
		streamIndex: 0,
		width: 320,
		height: 180,
		displayAspectRatio: { num: 16, den: 9 },
	},
	audio: { streamIndex: 1, sampleRate: 48000, channels: 2 },
};
const placed = () => ({
	id: randomUUID(),
	sourceKey: "a",
	startMs: 0,
	inMs: 0,
	outMs: 1000,
});
function request(): Extract<VodInputPreviewRequest, { kind: "PREVIEW" }> {
	return {
		kind: "PREVIEW",
		probeId: randomUUID(),
		document: {
			schemaVersion: 2,
			id: randomUUID(),
			audioEnabled: true,
			durationMs: 1000,
			videoClips: [placed()],
			audioClips: [placed()],
		},
		range: { startMs: 0, durationMs: 1000 },
	};
}
let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "bitovp-vod-render-guard-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("independent preview resource and identity guards", () => {
	it.each([
		"PROCESS_FAILED",
		"CANCELED",
	])("removes both passes' partial media when the audio pass ends with %s", async (code) => {
		const controller = new AbortController();
		const execute = vi.fn<typeof runMediaProcess>(
			async (_binary, argv, options) => {
				expect(options?.signal).toBe(controller.signal);
				expect(options?.timeoutMs).toBeGreaterThan(0);
				expect(options?.timeoutMs).toBeLessThanOrEqual(1000);
				expect(options?.maxOutputBytes).toBe(1024 ** 2);
				const output = argv.at(-1);
				if (!output) throw new Error("Missing fixture output");
				await writeFile(output, "partial");
				if (output.endsWith(".wav")) {
					if (code === "CANCELED") controller.abort();
					throw new MediaOperationError(code);
				}
				return { stdout: "", stderr: "" };
			},
		);
		await expect(
			renderVodInputPreview({
				request: request(),
				sources: [source],
				facts: [facts],
				directory,
				browserFor: vi.fn(),
				signal: controller.signal,
				timeoutMs: 1000,
				execute,
			}),
		).rejects.toMatchObject({ code });
		expect(execute).toHaveBeenCalledTimes(2);
		expect(await readdir(directory)).toEqual([]);
	});
	it("keeps object-version enforcement active during the second media pass", async () => {
		const browserFor = async (): Promise<ObjectStorageBrowser> => ({
			listBuckets: async () => [],
			listObjects: async () => ({ objects: [], prefixes: [] }),
			headObject: async () => identity,
			getObject: async () => {
				throw new ObjectVersionMismatchError(
					source.bucket,
					source.objectKey,
					identity,
				);
			},
		});
		const execute = vi.fn<typeof runMediaProcess>(async (_binary, argv) => {
			const output = argv.at(-1);
			if (!output) throw new Error("Missing fixture output");
			await writeFile(output, "partial");
			if (output.endsWith(".wav")) {
				const url = argv[argv.indexOf("-i") + 1];
				if (!url) throw new Error("Missing registered source URL");
				await fetch(url, { headers: { range: "bytes=0-999" } });
				throw new MediaOperationError("PROCESS_FAILED");
			}
			return { stdout: "", stderr: "" };
		});
		await expect(
			renderVodInputPreview({
				request: request(),
				sources: [source],
				facts: [facts],
				directory,
				browserFor,
				signal: new AbortController().signal,
				execute,
			}),
		).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
		expect(execute).toHaveBeenCalledTimes(2);
		expect(await readdir(directory)).toEqual([]);
	});
	it("rejects a native-unrepresentable gap before any CPU render or storage access", async () => {
		const input = request();
		if (input.document.schemaVersion !== 2) throw new Error("Expected v2");
		input.document.audioEnabled = false;
		input.document.durationMs = 12000;
		input.document.videoClips[0] = { ...placed(), startMs: 10001 };
		input.range = { startMs: 10001, durationMs: 1000 };
		const browserFor = vi.fn(),
			execute = vi.fn();
		await expect(
			renderVodInputPreview({
				request: input,
				sources: [source],
				facts: [facts],
				directory,
				browserFor,
				signal: new AbortController().signal,
				execute,
			}),
		).rejects.toMatchObject({ code: "TIMELINE_GAP_TOO_LONG" });
		expect(browserFor).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});
});
